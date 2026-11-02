import { CliError } from "@wirecat/cli-base"
import { type FACT_STATUSES, FACT_TYPES, MEMORY_SCOPES } from "../../domain/knowledge.js"
import { calendarMoment } from "../../domain/moment.js"
import { assertMayDecide, type Decider, deciderAuthor } from "../decisions.js"
import { type Actor, proposerOf } from "./actors.js"
import { type EvidenceSource, evidenceSourcesOf } from "./evidence-sources.js"
import { linkKind } from "./link-kinds.js"
import {
  type Author,
  authorActor,
  authorOf,
  dropLinksOf,
  erase,
  evidenceOf,
  keepHighestId,
  linkEvidence,
  nextId,
  projectOf,
  subjectOf,
} from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

/** What happened, as its evidence shows; its evidence is `links` of kind `evidence`. */
export interface Fact {
  id: string
  ref: string
  type: (typeof FACT_TYPES)[number]
  statement: string
  /** Proposed, then accepted or rejected; a correction supersedes it; only a decision is reversed. */
  status: (typeof FACT_STATUSES)[number]
  project: string | null
  projectName: string | null
  subject: string | null
  subjectName: string | null
  subjectIsOwner: boolean
  occurredAt: string | null
  supersedes: string | null
  /** `name` is a bot's handle; `null` for a person. */
  author: { type: Actor["type"]; id: string; name: string | null }
  model: string | null
  confirmedBy: { type: Actor["type"]; id: string } | null
  scope: (typeof MEMORY_SCOPES)[number] | null
  source: string
  evidence: string[]
  createdAt: string
  updatedAt: string
}

export interface FactInput {
  type: Fact["type"]
  statement: string
  /** Who records it: the owner's is accepted at once, an agent's waits as proposed. */
  by: Author
  project?: string
  subject?: string
  /** When it happened, as the evidence shows (ISO). */
  occurredAt?: string
  evidence?: string[]
  scope?: Fact["scope"] & string
  /** The proposed or accepted fact this one corrects, `superseded` once this one is accepted. */
  supersedes?: string
  /** The memory an agent drew it from: a `created-from` link. */
  createdFrom?: string
}

export interface FactsStore {
  add(input: FactInput): Promise<Fact>
  get(reference: string): Promise<Fact>
  list(options?: {
    type?: Fact["type"]
    project?: string
    subject?: string
    status?: Fact["status"]
    limit?: number
  }): Promise<Fact[]>
  /** The owner, or an agent for the owner, accepts a proposed fact; the fact it supersedes stops holding. */
  accept(reference: string, by: Decider): Promise<Fact>
  /** An accepted decision no longer holds and nothing replaced it. */
  reverse(reference: string): Promise<Fact>
  /** The owner, or an agent for the owner, turns down a proposed fact; it stays, marked `rejected`. */
  reject(reference: string, by: Decider): Promise<Fact>
  /**
   * Erases the fact: its row, its links, its tags, and the memory it was migrated from, which still held its text.
   * A decision that replaced it no longer names it. A backup made before keeps it.
   */
  remove(reference: string): Promise<{ ref: string; removed: true; links: number }>
  /** Each reference it rests on, read back; one deleted since is `missing`. */
  sources(reference: string): Promise<EvidenceSource[]>
}

type Row = Record<string, unknown>
const NAMED =
  "SELECT f.*, b.name AS author_name FROM facts f LEFT JOIN bots b ON f.author_type = 'bot' AND b.id = f.author_id"
const iso = (value: unknown) => new Date(Number(value)).toISOString()

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], what: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new CliError("validation_error", `${what} is one of ${allowed.join(", ")}`)
  return value as T
}

type FactOperations = {
  [K in keyof FactsStore]: FactsStore[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never
} & {
  /** Accepts as part of a decision already checked, such as a reviewed findings batch. */
  acceptChecked(reference: string): Fact
}

export const factOperationsOver = (context: StoreContext): FactOperations => {
  const { database, now } = context
  const factOf = (row: Row): Fact => ({
    id: String(row.id),
    ref: `fact:${row.id}`,
    type: row.type as Fact["type"],
    statement: String(row.statement),
    status: row.status as Fact["status"],
    ...projectOf(database, row),
    ...subjectOf(database, row),
    occurredAt: row.occurred_at == null ? null : iso(row.occurred_at),
    supersedes: row.supersedes_id == null ? null : `fact:${row.supersedes_id}`,
    author: authorOf(row),
    model: row.model == null ? null : String(row.model),
    confirmedBy:
      row.confirmed_by_type == null
        ? null
        : { type: row.confirmed_by_type as Actor["type"], id: String(row.confirmed_by_id) },
    scope: row.scope == null ? null : (row.scope as Fact["scope"]),
    source: String(row.source),
    evidence: evidenceOf(context, { type: "fact", id: Number(row.id) }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  })
  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `fact:${reference}`, "the fact")
    if (thing.type !== "fact") throw new CliError("validation_error", `${reference} is not a fact`)
    return database.prepare(`${NAMED} WHERE f.id = ?`).get(thing.id) as Row
  }
  const decided = (row: Row, by: Decider) =>
    assertMayDecide({ id: `fact:${row.id}`, proposedBy: proposerOf(database, row.author_type, row.author_id) }, by)
  const accept = (id: number, by: Decider = "owner") => {
    const row = database.prepare("SELECT * FROM facts WHERE id = ?").get(id) as Row
    if (row.status !== "proposed" && row.status !== "accepted")
      throw new CliError("validation_error", `a ${String(row.status)} fact cannot be accepted`)
    const { actor } = authorActor(context, deciderAuthor(by))
    const at = now()
    database
      .prepare(
        "UPDATE facts SET status = 'accepted', confirmed_by_type = ?, confirmed_by_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(actor.type, actor.id, at, id)
    if (row.supersedes_id != null)
      database
        .prepare(
          "UPDATE facts SET status = 'superseded', updated_at = ? WHERE id = ? AND status IN ('proposed', 'accepted')",
        )
        .run(at, Number(row.supersedes_id))
  }

  return {
    add: (input) => {
      const type = oneOf(input.type, FACT_TYPES, "a fact's type")
      const statement = input.statement?.trim() ?? ""
      if (!statement || statement.length > 2000)
        throw new CliError("validation_error", "a fact's statement takes 1–2000 characters")
      const scope = input.scope === undefined ? null : oneOf(input.scope, MEMORY_SCOPES, "a fact's scope")
      const occurredAt = input.occurredAt === undefined ? null : calendarMoment(input.occurredAt, "occurredAt")
      if (occurredAt !== null && !Number.isFinite(occurredAt))
        throw new CliError("validation_error", "occurredAt takes an ISO timestamp")
      const id = write(database, () => {
        const project = input.project === undefined ? undefined : requiredThing(database, input.project, "the project")
        if (project && project.type !== "project")
          throw new CliError("validation_error", `${input.project} is not a project`)
        const subject = input.subject === undefined ? undefined : requiredThing(database, input.subject, "the subject")
        const replaced = input.supersedes === undefined ? undefined : rowOf(input.supersedes)
        if (replaced && replaced.status !== "proposed" && replaced.status !== "accepted")
          throw new CliError(
            "validation_error",
            `${input.supersedes} is ${String(replaced.status)}; only a proposed or accepted fact can be corrected`,
          )
        const owner = input.by === "owner"
        const { actor, model } = authorActor(context, input.by)
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO facts (id, type, statement, status, project_id, subject_type, subject_id, occurred_at, supersedes_id, " +
                "author_type, author_id, model, scope, source, created_at, updated_at) " +
                "VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              nextId(database, "facts"),
              type,
              statement,
              project?.id ?? null,
              subject?.type ?? null,
              subject?.id ?? null,
              occurredAt,
              replaced === undefined ? null : Number(replaced.id),
              actor.type,
              actor.id,
              model,
              scope,
              owner ? "owner" : "agent",
              at,
              at,
            )?.id,
        )
        linkEvidence(context, { type: "fact", id: made }, input.evidence ?? [], owner ? "owner" : "agent")
        if (input.createdFrom !== undefined) {
          const from = requiredThing(database, input.createdFrom, "the source")
          database
            .prepare(
              "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author, updated_at) " +
                `VALUES ('fact', ?, ?, ?, ${linkKind("created-from")}, 'suggested', 1, ?, 'agent', ?)`,
            )
            .run(made, from.type, from.id, at, at)
        }
        if (owner) accept(made)
        return made
      })
      return factOf(rowOf(`fact:${id}`))
    },
    get: (reference) => factOf(rowOf(reference)),
    list: (options = {}) => {
      const project =
        options.project === undefined ? undefined : requiredThing(database, options.project, "the project")
      const subject = options.subject === undefined ? undefined : requiredThing(database, options.subject)
      return database
        .prepare(
          `${NAMED} WHERE f.deleted_at IS NULL AND (? IS NULL OR f.type = ?) AND (? IS NULL OR f.project_id = ?) ` +
            "AND (? IS NULL OR (f.subject_type = ? AND f.subject_id = ?)) AND (? IS NULL OR f.status = ?) " +
            "ORDER BY coalesce(f.occurred_at, f.created_at) DESC, f.id DESC LIMIT ?",
        )
        .all(
          options.type ?? null,
          options.type ?? null,
          project?.id ?? null,
          project?.id ?? null,
          subject?.type ?? null,
          subject?.type ?? null,
          subject?.id ?? null,
          options.status ?? null,
          options.status ?? null,
          Math.min(Math.max(options.limit ?? 100, 1), 500),
        )
        .map(factOf)
    },
    accept: (reference, by) => {
      const row = rowOf(reference)
      decided(row, by)
      write(database, () => accept(Number(row.id), by))
      return factOf(rowOf(reference))
    },
    acceptChecked: (reference) => {
      const id = Number(rowOf(reference).id)
      write(database, () => accept(id))
      return factOf(rowOf(reference))
    },
    reverse: (reference) => {
      const row = rowOf(reference)
      if (row.type !== "decision") throw new CliError("validation_error", "only a decision can be reversed")
      if (row.status !== "accepted") throw new CliError("validation_error", "only an accepted decision can be reversed")
      database.prepare("UPDATE facts SET status = 'reversed', updated_at = ? WHERE id = ?").run(now(), Number(row.id))
      return factOf(rowOf(reference))
    },
    reject: (reference, by) => {
      const row = rowOf(reference)
      decided(row, by)
      if (row.status !== "proposed")
        throw new CliError(
          "validation_error",
          `only a proposed fact can be rejected; this one is ${String(row.status)}`,
        )
      database.prepare("UPDATE facts SET status = 'rejected', updated_at = ? WHERE id = ?").run(now(), Number(row.id))
      return factOf(rowOf(reference))
    },
    remove: (reference) => {
      const row = rowOf(reference)
      const id = Number(row.id)
      const twin = row.source === "memory" && row.metadata != null ? migratedFrom(String(row.metadata)) : undefined
      const links = erase(database, () => {
        keepHighestId(database, "facts", now())
        if (twin !== undefined) keepHighestId(database, "memories", now())
        database.prepare("UPDATE facts SET supersedes_id = NULL WHERE supersedes_id = ?").run(id)
        const count = dropLinksOf(database, { type: "fact", id })
        database.prepare("DELETE FROM links WHERE from_type = 'fact' AND from_id = ?").run(id)
        database.prepare("DELETE FROM taggings WHERE taggable_type = 'fact' AND taggable_id = ?").run(id)
        database.prepare("DELETE FROM facts WHERE id = ?").run(id)
        if (twin !== undefined)
          database.prepare("DELETE FROM memories WHERE id = ? AND deleted_at IS NOT NULL").run(twin)
        return count
      })
      return { ref: `fact:${id}`, removed: true, links }
    },
    sources: (reference) => evidenceSourcesOf(database, { type: "fact", id: Number(rowOf(reference).id) }),
  }
}

const migratedFrom = (metadata: string): number | undefined => {
  try {
    const { memory } = JSON.parse(metadata) as { memory?: unknown }
    return Number.isInteger(memory) ? Number(memory) : undefined
  } catch {
    return undefined
  }
}

export const factsStoreOver = (context: StoreContext): FactsStore => {
  const operations = factOperationsOver(context)
  return {
    add: async (input) => operations.add(input),
    get: async (reference) => operations.get(reference),
    list: async (options) => operations.list(options),
    accept: async (reference, by) => operations.accept(reference, by),
    reverse: async (reference) => operations.reverse(reference),
    reject: async (reference, by) => operations.reject(reference, by),
    remove: async (reference) => operations.remove(reference),
    sources: async (reference) => operations.sources(reference),
  }
}
