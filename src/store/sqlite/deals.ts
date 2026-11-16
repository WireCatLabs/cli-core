import { CliError } from "@wirecat/cli-base"
import { timezoneOf } from "@wirecat/cli-base/query"
import type { ListResult } from "@wirecat/cli-base/standards"
import type { CrmValue } from "../../domain/crm.js"
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
import { dayIn } from "../../domain/moment.js"
import { currencyOf, formatDecimal, minorUnits, scaleOf } from "../../domain/money.js"
import { notOverriddenSql } from "../../domain/relations.js"
import { correctWords, type Vocabulary } from "../../search/correct.js"
import { createStemmer, DEFAULT_STEMMERS } from "../../search/stem.js"
import { fold } from "../normalize.js"
import type { AccountKey } from "../types.js"
import { type ProposedByFilter, proposedBySql } from "./actors.js"
import { suggestBaseStages } from "./base-suggest.js"
import { type CopyViewer, seenBy, viewerSql } from "./copy-viewer.js"
import { activityTexts } from "./crm-activities.js"
import { crmAccountPrefix } from "./crm-rows.js"
import { stageEntriesOf } from "./crm-stage-entries.js"
import { linkKind } from "./link-kinds.js"
import { type Author, authorActor, authorOf, evidenceOf, linkEvidence, projectId, projectOf } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import {
  bounded,
  boundOf,
  type FunnelCounts,
  openPerStage,
  type PipelinePeriod,
  pipelinePeriod,
} from "./pipeline-period.js"
import { type AuthorInfo, isoDate, limitOf, oneOf, type Party, refuse, reviewedRowsOver, text } from "./reviewed.js"
import { pageOfRows } from "./rows-page.js"
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

export interface FunnelStage extends PipelineStage, FunnelCounts {}

/** A pipeline with its funnel and outcomes over a window (`pipelinePeriod`). */
export interface PipelineReport extends Omit<Pipeline, "stages">, Omit<PipelinePeriod, "stages"> {
  stages: FunnelStage[]
  /** The window's bounds as ISO times; `null` is open. */
  window: { since: string | null; until: string | null }
}

/**
 * One stage a deal or a lead entered: from the CRM's own history (`exact`), else as the store saw it, a CRM copy's
 * change dated by the sync that saw it.
 */
export interface StageChange {
  /** `null` for the stage it started in, or the first the CRM's history names. */
  from: string | null
  to: string
  pipeline: string
  at: string
  exact: boolean
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
  /**
   * The stage of the owner's base set its stage maps to, once confirmed; a stage of the base set is its own. `null`
   * while unmapped or only suggested: a board shows it as unsorted.
   */
  baseStage: { ref: string; name: string } | null
  status: DealStatus
  organization: Party | null
  /** A CRM copy's own person and company as the CRM keeps them on the item, linked or not; `null` on the owner's own. */
  contactName: string | null
  companyName: string | null
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
  /** A CRM copy's assignee, as the identity `<account>/user/<id>`. */
  assignee: string | null
  /** A CRM copy's own fields by code, as the CRM labels them; empty on the owner's own. */
  providerMetadata: Record<string, CrmValue>
  people: DealPerson[]
  author: AuthorInfo
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

export interface PipelineOptions {
  kind?: DealKind
  since?: string
  until?: string
  zone?: string
  account?: DealScope
  viewer?: CopyViewer
}

/** Whose pipelines: the owner's own, one CRM account's copies, or, left out, every one. */
export type DealScope = "own" | AccountKey

export interface TimeBounds {
  since?: number
  until?: number
}

export interface DealFilter {
  /** `deal` when left out. */
  kind?: DealKind
  /** Only the owner's own, or only one CRM account's copies. */
  account?: DealScope
  /** Copies only from these CRM accounts; the owner's and agents' own always, as `listRelations` keeps theirs. */
  accounts?: AccountKey[]
  status?: DealStatus
  /** A stage's name, in any letter case. */
  stage?: string
  /** `pipeline:<id>`, or a name only one pipeline of the kind has. */
  pipeline?: string
  project?: string
  organization?: string
  proposedBy?: ProposedByFilter
  /** A CRM copy's assignee as the identity `<account>/user/<id>`; `null` is none. */
  owner?: string | null
  /** Epoch ms bounds, inclusive, on when the CRM changed or made it. */
  updated?: TimeBounds
  created?: TimeBounds
  /** On the day it was won or lost, the bounds' days in `zone` (the system's when left out). */
  closed?: TimeBounds
  zone?: string
  viewer?: CopyViewer
  /** 1–500, 100 by default; newest written first. */
  limit?: number
  /** Rows to skip before the first one answered, for the next page. */
  offset?: number
}

export interface DealSearch {
  /**
   * Words of the title, the company or a contact's name, e-mail or phone, each in any letter case; a word may be a
   * phrase, whose words must follow each other.
   */
  words: string[]
  /** A row holding any of the words matches, those holding more first; otherwise every word is needed. */
  anyWord?: boolean
  /** Only whole words as typed: no other form of a word, no word it begins, no spelling correction. */
  exact?: boolean
  /** Only the copies of these CRM accounts; absent, every account's and the owner's own. */
  accounts?: AccountKey[]
  /** Only these kinds; absent, deals and leads. */
  kinds?: readonly DealKind[]
  viewers?: CopyViewer[]
  /** 1–500, 100 by default. */
  limit?: number
  offset?: number
}

/** Where a deal's or a lead's words are searched: its title, its company, the people on it, its CRM activities. */
export type DealPart = "title" | "company" | "contact" | "activity"

export interface FoundDeal extends Deal {
  /** Where the query's words were found, in the order of `DealPart`. */
  matched: DealPart[]
  /** Set when nothing matched as typed: each query word that was corrected, and the stored words it became. */
  corrections?: { from: string; to: string[] }[]
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
  pipelines(filter?: { kind?: DealKind; account?: DealScope; viewer?: CopyViewer }): Promise<Pipeline[]>
  /**
   * One pipeline by `pipeline:<id>` or a name only one pipeline has, with its funnel and outcomes over the window:
   * `since` and `until` are a `YYYY-MM-DD` day or an ISO time, `zone` the owner's for closed days.
   */
  pipeline(reference: string, options?: PipelineOptions): Promise<PipelineReport>
  add(input: DealInput): Promise<Deal>
  /** `deal:<id>` or `lead:<id>`; a bare id is a deal. */
  get(reference: string): Promise<Deal>
  /** Every stage it entered, in the order it entered them: a CRM's own stamps may run out of order. */
  stages(reference: string): Promise<StageChange[]>
  list(filter?: DealFilter): Promise<ListResult<Deal>>
  /**
   * Deals and leads together, by the words of their title, company, contacts and the subjects and texts of their CRM
   * activities (calls, e-mails, meetings, tasks): a query word matches a stored word
   * it begins or one of the same stem. The most words matched first, then the latest changed. When nothing matches,
   * a misspelt word is corrected to the stored words nearest to it, once.
   */
  find(search: DealSearch): Promise<ListResult<FoundDeal>>
  /**
   * The project it belongs to; `null` clears it. A CRM copy takes it too: the project is the store's own field, which
   * a CRM has none of and its sync never writes.
   */
  setProject(reference: string, input: { project: string | null; by: Author }): Promise<Deal>
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
  "b.kind AS author_kind, a.provider AS account_provider, a.external_id AS account_external_id, " +
  "bs.id AS base_stage_ref_id, bs.name AS base_stage_name " +
  `FROM ${TABLES[kind]} d JOIN pipeline_stages s ON s.id = d.stage_id JOIN pipelines p ON p.id = s.pipeline_id ` +
  "LEFT JOIN bots b ON d.author_type = 'bot' AND b.id = d.author_id LEFT JOIN accounts a ON a.id = d.account_id " +
  "LEFT JOIN pipeline_stages bs ON s.base_confirmed = 1 AND bs.id = s.base_stage_id"

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

const isValue = (value: unknown): value is CrmValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "label" in value && "value" in value

const providerMetadataOf = (metadata: unknown): Record<string, CrmValue> => {
  if (metadata == null) return {}
  try {
    return Object.fromEntries(
      Object.entries(JSON.parse(String(metadata)) as Record<string, unknown>).filter(([, value]) => isValue(value)),
    ) as Record<string, CrmValue>
  } catch {
    return {}
  }
}

const accountOf = (provider: unknown, external: unknown) =>
  provider == null ? null : { provider: String(provider), account: String(external) }

const DEAL_PARTS: readonly DealPart[] = ["title", "company", "contact", "activity"]
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu
/** A query word shorter than this matches only a whole word: «с» or "a" begins half the words of any title. */
const SHORTEST_BEGINNING = 4
const stemmer = createStemmer(DEFAULT_STEMMERS, { cacheLimit: 20_000 })
const stemsOf = (token: string) => stemmer.stemSequences(token).flat()

type StoredWord = { token: string; literal: string }
type Probe = { literal: string; stems: string[] }
/** One word of a query clause, with the corrections that may stand for it. */
type QueryWord = Probe[]

const probeOf = (token: string): Probe => ({ literal: fold(token), stems: stemsOf(token) })
const tokensOf = (text: string) => text.normalize("NFC").toLowerCase().match(TOKEN) ?? []

const wordMatches = (probe: Probe, word: StoredWord, exact: boolean): boolean => {
  if (word.literal === probe.literal) return true
  if (exact) return false
  if (probe.literal.length >= SHORTEST_BEGINNING && word.literal.startsWith(probe.literal)) return true
  // A stem begins its word, so a word that does not start like the stem needs no stemming.
  return (
    probe.stems.some((stem) => word.literal.startsWith(stem.slice(0, 3))) &&
    stemsOf(word.token).some((stem) => probe.stems.includes(stem))
  )
}

/** A clause of several words, `КТП-630` or an e-mail, matches only where they follow each other. */
const clauseIn = (clause: QueryWord[], words: StoredWord[], exact: boolean): boolean =>
  words.some((_, at) =>
    clause.every((alternatives, offset) => {
      const word = words[at + offset]
      return word !== undefined && alternatives.some((probe) => wordMatches(probe, word, exact))
    }),
  )

const listOf = (json: unknown): string[] => {
  if (typeof json !== "string") return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export const dealOperationsOver = (context: StoreContext) => {
  const { database, now } = context
  const { partyOf, partyThing } = reviewedRowsOver(context)
  const today = () => new Date(now()).toISOString().slice(0, 10)

  const peopleOf = (kind: DealKind, id: number): DealPerson[] =>
    database
      .prepare(
        `SELECT to_id, role FROM links WHERE from_type = ? AND from_id = ? AND kind = ${linkKind("related-to")} ` +
          `AND to_type = 'person' AND to_id IS NOT NULL AND deleted_at IS NULL AND ${notOverriddenSql("links")} ORDER BY id`,
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
        baseStage:
          row.base_stage_ref_id == null
            ? null
            : { ref: `stage:${row.base_stage_ref_id}`, name: String(row.base_stage_name) },
        status: fields.status,
        organization: partyOf(row.organization_id == null ? null : "organization", row.organization_id),
        contactName: jsonField(row.metadata, "contact_name"),
        companyName: jsonField(row.metadata, "company_name"),
        currency,
        amount: amount === null || currency === null ? null : formatDecimal(amount, scaleOf(currency)),
        closeDate: row.close_date == null ? null : String(row.close_date),
        closedDate: row.closed_date == null ? null : String(row.closed_date),
        closedReason: jsonField(row.metadata, "closed_reason"),
        rank: row.rank == null ? null : Number(row.rank),
        deal: row.deal_id == null ? null : `deal:${row.deal_id}`,
        account: accountOf(row.account_provider, row.account_external_id),
        externalId: row.external_id == null ? null : String(row.external_id),
        assignee: jsonField(row.metadata, "assignee"),
        providerMetadata: providerMetadataOf(row.metadata),
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

  const inScope = (scope: DealScope | undefined, row: Row) =>
    scope === undefined ||
    (scope === "own"
      ? row.account_id == null
      : row.account_provider === scope.provider && row.account_external_id === scope.account)

  const kindOf = (kind: unknown): DealKind => (kind === undefined ? "deal" : oneOf(kind, DEAL_KINDS, "a kind"))

  /** A pipeline the CRM deleted is left out, unless named by its reference: its deals still stand in it. */
  const pipelineRows = (kind: DealKind | undefined, scope?: DealScope, { deleted = false } = {}) =>
    database
      .prepare(
        "SELECT p.*, a.provider AS account_provider, a.external_id AS account_external_id FROM pipelines p " +
          "LEFT JOIN accounts a ON a.id = p.account_id WHERE (? IS NULL OR p.kind = ?) " +
          `${deleted ? "" : "AND p.deleted_at IS NULL "}ORDER BY p.name_folded, p.id`,
      )
      .all(kind ?? null, kind ?? null)
      .filter((row) => inScope(scope, row))

  const label = (row: Row) =>
    `pipeline:${row.id} (${row.name}${row.account_provider == null ? "" : `, ${row.account_provider}:${row.account_external_id}`})`

  /** A pipeline by `pipeline:<id>`, or by a name only one pipeline of the kind has; never a guess. */
  const pipelineRow = (reference: string, kind: DealKind | undefined, scope?: DealScope): Row => {
    const named = reference.trim()
    if (/^pipeline:\d+$/.test(named)) {
      const row = pipelineRows(kind, scope, { deleted: true }).find((one) => `pipeline:${one.id}` === named)
      if (!row) throw new CliError("not_found", `no ${kind ?? ""} pipeline ${named}`, { reason: "pipeline.not-found" })
      return row
    }
    const rows = pipelineRows(kind, scope).filter((one) => one.name_folded === fold(named))
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

  const pipelinesOf = (rows: Row[], viewer?: CopyViewer): Pipeline[] => {
    const ids = rows.map((row) => Number(row.id))
    const stages = openPerStage(database, ids, viewer)
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

  /**
   * A stage by name in one pipeline, or in the only one of the owner's pipelines of the kind that has one of that
   * name: a CRM's stages are its own, and a deal written here into one would be undone by the next sync.
   */
  const stageRow = (stage: string, kind: DealKind, pipeline: number | undefined): Row => {
    const rows = database
      .prepare(
        "SELECT s.*, p.name AS pipeline_name FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id " +
          "WHERE s.name_folded = ? AND p.kind = ? AND (? IS NULL OR p.id = ?) AND (? IS NOT NULL OR p.account_id IS NULL) " +
          "ORDER BY p.id",
      )
      .all(fold(stage.trim()), kind, pipeline ?? null, pipeline ?? null, pipeline ?? null)
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
    const pipelines = pipeline === undefined ? pipelineRows(kind, "own") : [{ id: pipeline }]
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

  const funnelOf = (pipeline: Pipeline, options: PipelineOptions): PipelineReport => {
    const { since, until, zone = timezoneOf(), viewer } = options
    const window = {
      since: boundOf(since, "the first day counted", zone),
      until: boundOf(until, "the last day counted", zone, true),
    }
    const { stages, ...period } = pipelinePeriod(context, pipeline, window, zone, viewer)
    const at = (bound: number | null) => (bound === null ? null : new Date(bound).toISOString())
    return {
      ...pipeline,
      ...period,
      stages: pipeline.stages.map((stage, index) => ({ ...stage, ...(stages[index] as FunnelCounts) })),
      window: { since: at(window.since), until: at(window.until) },
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
    if (row.account_id != null)
      refuse(
        `${kind}:${row.id} is a copy from ${row.account_provider}:${row.account_external_id}; change it there, and ` +
          "its next sync brings the change here",
        "deal.copy",
      )
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
        suggestBaseStages(database, pipelineKind, [made])
        return made
      })
      return pipelinesOf(
        pipelineRows(pipelineKind, undefined, { deleted: true }).filter((row) => Number(row.id) === id),
      )[0] as Pipeline
    },
    pipelines: ({ kind, account, viewer }: { kind?: DealKind; account?: DealScope; viewer?: CopyViewer } = {}) =>
      pipelinesOf(pipelineRows(kind === undefined ? undefined : kindOf(kind), account), viewer),
    pipeline: (reference: string, options: PipelineOptions = {}): PipelineReport => {
      const kind = options.kind === undefined ? undefined : kindOf(options.kind)
      const [found] = pipelinesOf([pipelineRow(reference, kind, options.account)], options.viewer)
      return funnelOf(found as Pipeline, options)
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
        const pipeline = input.pipeline === undefined ? undefined : Number(pipelineRow(input.pipeline, kind, "own").id)
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
          "INSERT OR IGNORE INTO links (from_type, from_id, to_type, to_id, kind, role, source, confirmed, created_at, author, " +
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
    stages: (reference: string): StageChange[] => {
      const { kind, row } = rowOf(reference)
      const own = stageEntriesOf(database, kind, { item: Number(row.id) })
      const stages = new Map(
        database
          .prepare(
            `SELECT id, name, pipeline_id FROM pipeline_stages WHERE id IN (${own.map(() => "?").join(", ") || "NULL"})`,
          )
          .all(...own.map(({ toStageId }) => toStageId))
          .map((stage) => [Number(stage.id), stage]),
      )
      return own.map((entry, at) => {
        const stage = stages.get(entry.toStageId) as Row
        const before = at === 0 ? undefined : stages.get((own[at - 1] as typeof entry).toStageId)
        return {
          from: before === undefined ? null : String(before.name),
          to: String(stage.name),
          pipeline: `pipeline:${stage.pipeline_id}`,
          at: iso(entry.at),
          exact: entry.exact,
        }
      })
    },
    list: (filter: DealFilter = {}): ListResult<Deal> => {
      const kind = kindOf(filter.kind)
      const project = filter.project === undefined ? null : projectId(database, filter.project)
      const organization = partyThing(filter.organization, "the organization")
      const by = proposedBySql("d.author_type", "d.author_id", filter.proposedBy)
      const status = filter.status === undefined ? null : oneOf(filter.status, DEAL_STATUSES, "a status")
      const stage = filter.stage === undefined ? null : fold(filter.stage.trim())
      const pipeline =
        filter.pipeline === undefined ? null : Number(pipelineRow(filter.pipeline, kind, filter.account).id)
      const scope = filter.account
      const own = scope === "own" ? 1 : 0
      const provider = scope === undefined || scope === "own" ? null : scope.provider
      const account = scope === undefined || scope === "own" ? null : scope.account
      const limit = limitOf(filter.limit)
      const keys = filter.accounts?.map((one) => `${one.provider}:${one.account}`)
      const inAccounts =
        keys === undefined
          ? ""
          : `AND (d.account_id IS NULL OR a.provider || ':' || a.external_id IN (${keys.map(() => "?").join(", ") || "NULL"})) `
      const offset = Math.max(0, Math.trunc(filter.offset ?? 0))
      const zone = filter.zone ?? timezoneOf()
      const days = {
        since: filter.closed?.since === undefined ? undefined : dayIn(filter.closed.since, zone),
        until: filter.closed?.until === undefined ? undefined : dayIn(filter.closed.until, zone),
      }
      const within = [
        ...(filter.viewer ? [viewerSql("d", filter.viewer)] : []),
        ...bounded("d.updated_at", filter.updated),
        ...bounded("d.closed_date", filter.closed && days),
        ...bounded("d.created_at", filter.created),
        ...(filter.owner === undefined
          ? []
          : [
              filter.owner === null
                ? { sql: "json_extract(d.metadata, '$.assignee') IS NULL", params: [] }
                : { sql: "json_extract(d.metadata, '$.assignee') = ?", params: [filter.owner] },
            ]),
      ]
      const rows = database
        .prepare(
          `${itemsSql(kind)} WHERE d.deleted_at IS NULL ${within.map(({ sql }) => `AND ${sql} `).join("")}` +
            "AND (? IS NULL OR d.status = ?) " +
            "AND (? IS NULL OR d.project_id = ?) AND (? IS NULL OR s.name_folded = ?) AND (? IS NULL OR p.id = ?) " +
            "AND (? IS NULL OR d.organization_id = ?) AND (? = 0 OR d.account_id IS NULL) " +
            `AND (? IS NULL OR (a.provider = ? AND a.external_id = ?)) ${inAccounts}AND ${by.sql} ` +
            "ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?",
        )
        .all(
          ...within.flatMap(({ params }) => params),
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
          own,
          provider,
          provider,
          account,
          ...(keys ?? []),
          ...by.params,
          limit + 1,
          offset,
        )
        .map(itemOf(kind))
      return pageOfRows(rows, limit, offset)
    },
    find: async (wanted: DealSearch): Promise<ListResult<FoundDeal>> => {
      const { words, anyWord, exact = false, accounts, kinds = DEAL_KINDS, limit, offset = 0, viewers = [] } = wanted
      const seen = new Set<string>()
      const clauses = words
        .map((word) => tokensOf(word).filter((token) => fold(token)))
        .filter((tokens) => {
          const key = tokens.map(fold).join(" ")
          if (!tokens.length || seen.has(key)) return false
          seen.add(key)
          return true
        })
      const most = Math.min(Math.max(limit ?? 100, 1), 500)
      if (!clauses.length) return { items: [], hasMore: false }
      const within = accounts?.map(({ provider, account }) => `${provider}\u0000${account}`)
      const stored = new Map<string, StoredWord>()
      const wordsOf = (text: string) =>
        tokensOf(text).flatMap((token) => {
          let word = stored.get(token)
          if (word === undefined) {
            word = { token, literal: fold(token) }
            stored.set(token, word)
          }
          return word.literal ? [word] : []
        })
      // A CRM holds thousands of rows, not millions: reading their words here is cheaper than an index kept in step.
      const records = kinds.flatMap((kind) => {
        const contacts = new Map<number, Set<string>>()
        // `+` keeps SQLite off the index by `to_type`: a store holds far more links to people than links from deals.
        for (const row of database
          .prepare(
            "SELECT k.from_id, a.provider AS account_provider, a.external_id AS account, p.name, i.provider, " +
              "i.external_id, i.name AS identity, i.email, i.phone, " +
              "CASE WHEN json_valid(i.metadata) THEN json_extract(i.metadata, '$.emails') END AS emails, " +
              "CASE WHEN json_valid(i.metadata) THEN json_extract(i.metadata, '$.phones') END AS phones " +
              `FROM links k JOIN ${TABLES[kind]} d ON d.id = k.from_id JOIN persons p ON p.id = k.to_id ` +
              "LEFT JOIN accounts a ON a.id = d.account_id LEFT JOIN identity_links l ON l.person_id = p.id " +
              "LEFT JOIN identities i ON i.id = l.identity_id " +
              `WHERE k.from_type = ? AND d.deleted_at IS NULL AND k.kind = ${linkKind("related-to")} ` +
              "AND +k.to_type = 'person' AND k.deleted_at IS NULL AND k.role IS NOT 'owner' " +
              `AND ${notOverriddenSql("k")}`,
          )
          .all(kind)) {
          const texts = contacts.get(Number(row.from_id)) ?? new Set<string>()
          contacts.set(Number(row.from_id), texts)
          if (typeof row.name === "string" && row.name) texts.add(row.name)
          // A CRM copy is found only by what its CRM holds: a locked profile never learns a person's other accounts.
          const own =
            row.account_provider == null ||
            (row.provider === row.account_provider &&
              String(row.external_id).startsWith(
                crmAccountPrefix({ provider: String(row.account_provider), account: String(row.account) }),
              ))
          if (!own) continue
          const phones = [row.phone, ...listOf(row.phones)].filter((one): one is string => typeof one === "string")
          for (const text of [row.identity, row.email, ...listOf(row.emails), ...phones])
            if (typeof text === "string" && text) texts.add(text)
          // `+7 916 123-45-67` is one number to whoever types `79161234567`.
          for (const phone of phones) texts.add(phone.replace(/\D/g, ""))
        }
        const activities = activityTexts(database, kind)
        return database
          .prepare(
            `SELECT d.id, d.account_id, d.external_id, d.title, d.updated_at, a.provider, a.external_id AS account, o.name AS company, ` +
              "CASE WHEN json_valid(d.metadata) THEN json_extract(d.metadata, '$.company_name') END AS own_company, " +
              "CASE WHEN json_valid(d.metadata) THEN json_extract(d.metadata, '$.contact_name') END AS own_contact, " +
              "CASE WHEN json_valid(d.metadata) THEN json_extract(d.metadata, '$.assignee') END AS assignee " +
              `FROM ${TABLES[kind]} d LEFT JOIN accounts a ON a.id = d.account_id ` +
              "LEFT JOIN organizations o ON o.id = d.organization_id WHERE d.deleted_at IS NULL",
          )
          .all()
          .filter((row) => within === undefined || within.includes(`${row.provider}\u0000${row.account}`))
          .filter((row) => viewers.every((viewer) => seenBy(viewer, row)))
          .map((row) => ({
            kind,
            row,
            parts: [
              { part: "title" as const, words: wordsOf(String(row.title)) },
              ...[row.company, row.own_company]
                .filter((text) => typeof text === "string")
                .map((text) => ({ part: "company" as const, words: wordsOf(text) })),
              ...[row.own_contact, ...(contacts.get(Number(row.id)) ?? [])]
                .filter((text) => typeof text === "string")
                .map((text) => ({ part: "contact" as const, words: wordsOf(text) })),
              ...(activities.get(`${row.account_id}\u0000${row.external_id}`) ?? []).map((text) => ({
                part: "activity" as const,
                words: wordsOf(text),
              })),
            ],
          }))
      })
      const search = (query: QueryWord[][]) =>
        records
          .map((record) => {
            const matched = new Set<DealPart>()
            const score = query.filter((clause) => {
              const where = record.parts.filter(({ words: held }) => clauseIn(clause, held, exact))
              for (const { part } of where) matched.add(part)
              return where.length > 0
            }).length
            return { ...record, score, matched: DEAL_PARTS.filter((part) => matched.has(part)) }
          })
          .filter(({ score }) => (anyWord ? score > 0 : score === query.length))
      const probes = clauses.map((clause) => clause.map(probeOf))
      const queryWith = (fixes: Map<string, string[]>) =>
        probes.map((clause) => clause.map((probe) => [probe, ...(fixes.get(probe.literal) ?? []).map(probeOf)]))
      let found = search(queryWith(new Map()))
      let corrections: { from: string; to: string[] }[] | undefined
      if (!found.length && !exact) {
        const docs = new Map<string, number>()
        for (const { parts } of records)
          for (const literal of new Set(parts.flatMap(({ words: held }) => held.map((word) => word.literal))))
            docs.set(literal, (docs.get(literal) ?? 0) + 1)
        const vocabulary: Vocabulary = {
          knownTerms: async (terms) => new Set(terms.filter((term) => docs.has(term))),
          termCandidates: async (_, { shortest, longest }) =>
            [...docs]
              .filter(([term]) => term.length >= shortest && term.length <= longest)
              .map(([term, count]) => ({ term, docs: count })),
        }
        const unmatched = probes
          .flat()
          .filter((probe) => ![...stored.values()].some((word) => wordMatches(probe, word, false)))
          .map(({ literal }) => literal)
        const fixes = unmatched.length ? await correctWords(vocabulary, [...new Set(unmatched)]) : new Map()
        if (fixes.size) {
          corrections = [...fixes].map(([from, to]) => ({ from, to }))
          found = search(queryWith(fixes))
        }
      }
      const ranked = found
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(b.row.updated_at) - Number(a.row.updated_at) ||
            Number(b.row.id) - Number(a.row.id),
        )
        .slice(offset, offset + most + 1)
        .map(
          ({ kind, row, matched }): FoundDeal => ({
            ...read(`${kind}:${row.id}`),
            matched,
            ...(corrections ? { corrections } : {}),
          }),
        )
      return pageOfRows(ranked, most, offset)
    },
    setProject: (reference: string, { project, by }: { project: string | null; by: Author }): Deal => {
      authorActor(context, by)
      const { kind, row } = rowOf(reference)
      if (row.deleted_at != null) refuse(`${kind}:${row.id} is deleted; it no longer changes`, "deal.closed")
      const id = project === null ? null : projectId(database, project)
      write(database, () =>
        database
          .prepare(`UPDATE ${TABLES[kind]} SET project_id = ?, updated_at = ? WHERE id = ?`)
          .run(id, now(), Number(row.id)),
      )
      return read(`${kind}:${row.id}`)
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
    stages: async (reference) => operations.stages(reference),
    list: async (filter) => operations.list(filter),
    find: async (search) => operations.find(search),
    setProject: async (reference, input) => operations.setProject(reference, input),
    move: async (reference, input) => operations.move(reference, input),
    close: async (reference, input) => operations.close(reference, input),
  }
}
