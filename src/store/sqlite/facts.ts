import { CliError } from "@wirecat/cli-base"
import type { ListResult } from "@wirecat/cli-base/standards"
import { type FACT_STATUSES, FACT_TYPES, MEMORY_SCOPES } from "../../domain/knowledge.js"
import { calendarMoment } from "../../domain/moment.js"
import { assertMayDecide, assertMayWithdraw, type Decider, deciderAuthor } from "../decisions.js"
import type { SourceReviewMarker } from "../source-review.js"
import { type Actor, type ProposedByFilter, proposedBySql, proposerOf } from "./actors.js"
import type { EvidenceInput } from "./evidence-signature.js"
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
import { idsOf } from "./merged-persons.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { pageOfRows } from "./rows-page.js"
import { closeSourceReviews, eraseSourceReviews, sourceReviewOf } from "./source-review-marks.js"
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
  /** `name` is a bot's handle and `kind` whether it is an agent or a rule; both `null` for a person. */
  author: { type: Actor["type"]; id: string; name: string | null; kind: "agent" | "rule" | null }
  model: string | null
  confirmedBy: { type: Actor["type"]; id: string } | null
  scope: (typeof MEMORY_SCOPES)[number] | null
  source: string
  evidence: string[]
  /** The open review of its sources (`memory_source_review`), when one waits for the owner. */
  sourceReview: SourceReviewMarker | null
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
  evidence?: EvidenceInput[]
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
    proposedBy?: ProposedByFilter
    /** `created` lists the newest written first; by default the newest by when it happened. */
    order?: "occurred" | "created"
    limit?: number
    /** Rows to skip, for the next page in the same order, ties by id. */
    offset?: number
  }): Promise<ListResult<Fact>>
  /** The owner, or an agent for the owner, accepts a proposed fact; the fact it supersedes stops holding. */
  accept(reference: string, by: Decider, reason?: string): Promise<Fact>
  /** An accepted decision no longer holds and nothing replaced it. */
  reverse(reference: string, by: Decider): Promise<Fact>
  /**
   * The owner takes back the approval of an accepted fact an agent proposed: it waits as `proposed` again. The step is
   * kept in `metadata.history`, with the decision it took back.
   */
  revoke(reference: string, by: Decider, reason?: string): Promise<Fact>
  /** The owner, or an agent for the owner, turns down a proposed fact; it stays, marked `rejected`. */
  reject(reference: string, by: Decider, reason?: string): Promise<Fact>
  /**
   * Erases the fact: its row, its links, its tags, and the memory it was migrated from, which still held its text.
   * Evidence of memories and facts that cited it stays with no pointer and shows as a missing source; `links` counts
   * the links erased. A decision that replaced it no longer names it. A backup made before keeps it.
   */
  remove(reference: string, by: Decider): Promise<{ ref: string; removed: true; links: number }>
  /** Each reference it rests on, read back; one deleted since is `missing`. */
  sources(reference: string): Promise<EvidenceSource[]>
}

type Row = Record<string, unknown>
const NAMED =
  "SELECT f.*, b.name AS author_name, b.kind AS author_kind FROM facts f LEFT JOIN bots b ON f.author_type = 'bot' AND b.id = f.author_id"
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
  acceptChecked(reference: string, by: Decider): Fact
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
    sourceReview: sourceReviewOf(database, { type: "fact", id: Number(row.id) }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  })
  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `fact:${reference}`, "the fact")
    if (thing.type !== "fact") throw new CliError("validation_error", `${reference} is not a fact`)
    return database.prepare(`${NAMED} WHERE f.id = ?`).get(thing.id) as Row
  }
  const withdrawn = (row: Row, by: Decider) =>
    assertMayWithdraw(
      {
        id: `fact:${row.id}`,
        proposedBy: proposerOf(database, row.author_type, row.author_id),
        proposed: row.status === "proposed",
      },
      by,
    )
  const decided = (row: Row, by: Decider, ownerOnly = false) =>
    assertMayDecide(
      {
        id: `fact:${row.id}`,
        proposedBy: proposerOf(database, row.author_type, row.author_id),
        ownerOnly,
      },
      by,
      context.decisions,
    )
  /** Accepting it would retire a fact the owner stands behind, which only the owner may, as for memories. */
  const retiresAccepted = (row: Row): boolean =>
    row.status === "proposed" &&
    row.supersedes_id != null &&
    database.prepare("SELECT 1 FROM facts WHERE id = ? AND status = 'accepted'").get(Number(row.supersedes_id)) !==
      undefined
  /** Keeps who decided for the owner and why in `metadata.decision`; the decider's actor is in `confirmed_by`. */
  const keepDecision = (id: number, by: Decider, reason?: string) => {
    const why = [by === "owner" ? undefined : by.reason.trim(), reason?.trim() || undefined].filter(Boolean).join(": ")
    if (by === "owner" && !why) return
    const decision = by === "owner" ? { by: "owner", reason: why } : { by: "agent", bot: by.bot, reason: why }
    database
      .prepare("UPDATE facts SET metadata = json_set(coalesce(metadata, '{}'), '$.decision', json(?)) WHERE id = ?")
      .run(JSON.stringify(decision), id)
  }
  const accept = (id: number, by: Decider = "owner", reason?: string) => {
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
    keepDecision(id, by, reason)
    if (row.supersedes_id != null) {
      database
        .prepare(
          "UPDATE facts SET status = 'superseded', updated_at = ? WHERE id = ? AND status IN ('proposed', 'accepted')",
        )
        .run(at, Number(row.supersedes_id))
      closeSourceReviews(database, { type: "fact", id: Number(row.supersedes_id) }, { actor, at, why: "superseded" })
    }
  }
  const closing = (id: number, by: Decider, why: string) =>
    closeSourceReviews(
      database,
      { type: "fact", id },
      { actor: authorActor(context, deciderAuthor(by)).actor, at: now(), why },
    )

  return {
    add: (input) => {
      if ((input.type as string) === "payment")
        throw new CliError(
          "validation_error",
          "a payment is not a fact: record it with store.finance.addPayment, a payment: row, or an invoice: for one expected",
          { reason: "fact.payment-retired" },
        )
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
                "author_type, author_id, model, scope, source, metadata, created_at, updated_at) " +
                "VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
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
              null,
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
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
      const offset = Math.max(options.offset ?? 0, 0)
      const project =
        options.project === undefined ? undefined : requiredThing(database, options.project, "the project")
      const subject = options.subject === undefined ? undefined : requiredThing(database, options.subject)
      const by = proposedBySql("f.author_type", "f.author_id", options.proposedBy)
      const order = options.order === "created" ? "f.created_at" : "coalesce(f.occurred_at, f.created_at)"
      const rows = database
        .prepare(
          `${NAMED} WHERE f.deleted_at IS NULL AND (? IS NULL OR f.type = ?) AND (? IS NULL OR f.project_id = ?) ` +
            "AND (? IS NULL OR (f.subject_type = ? AND f.subject_id IN (SELECT value FROM json_each(?)))) AND (? IS NULL OR f.status = ?) " +
            `AND ${by.sql} ORDER BY ${order} DESC, f.id DESC LIMIT ? OFFSET ?`,
        )
        .all(
          options.type ?? null,
          options.type ?? null,
          project?.id ?? null,
          project?.id ?? null,
          subject?.type ?? null,
          subject?.type ?? null,
          subject ? idsOf(database, subject.type, subject.id) : null,
          options.status ?? null,
          options.status ?? null,
          ...by.params,
          limit + 1,
          offset,
        )
        .map(factOf)
      return pageOfRows(rows, limit, offset)
    },
    accept: (reference, by, reason) => {
      const row = rowOf(reference)
      decided(row, by, retiresAccepted(row))
      write(database, () => accept(Number(row.id), by, reason))
      return factOf(rowOf(reference))
    },
    acceptChecked: (reference, by) => {
      const id = Number(rowOf(reference).id)
      write(database, () => accept(id, by))
      return factOf(rowOf(reference))
    },
    reverse: (reference, by) => {
      const row = rowOf(reference)
      assertMayWithdraw({ id: `fact:${row.id}`, proposedBy: { type: "unknown" }, proposed: false }, by)
      if (row.type !== "decision") throw new CliError("validation_error", "only a decision can be reversed")
      if (row.status !== "accepted") throw new CliError("validation_error", "only an accepted decision can be reversed")
      write(database, () => {
        database.prepare("UPDATE facts SET status = 'reversed', updated_at = ? WHERE id = ?").run(now(), Number(row.id))
        closing(Number(row.id), by, "reversed")
      })
      return factOf(rowOf(reference))
    },
    revoke: (reference, by, reason) => {
      const row = rowOf(reference)
      const ref = `fact:${row.id}`
      assertMayWithdraw({ id: ref, proposedBy: { type: "unknown" }, proposed: false }, by)
      write(database, () => {
        const current = database.prepare("SELECT * FROM facts WHERE id = ?").get(Number(row.id)) as Row
        if (current.status !== "accepted")
          throw new CliError(
            "validation_error",
            `only an accepted fact can be revoked; ${ref} is ${String(current.status)}`,
            { reason: "fact.not-accepted" },
          )
        if (current.author_type === "person")
          throw new CliError(
            "validation_error",
            `${ref} is the owner's own fact, never proposed; correct it with a fact that supersedes it, or remove it`,
            { reason: "fact.owner-written" },
          )
        // Accepting it marked the fact it corrects superseded, and what that one was before is not kept.
        if (current.supersedes_id != null)
          throw new CliError(
            "validation_error",
            `${ref} corrects fact:${current.supersedes_id}, which stopped holding when ${ref} was accepted; ` +
              "remove it or correct it with another fact instead",
            { reason: "fact.revoke-correction" },
          )
        const at = now()
        const { decision, history, ...metadata } = (
          current.metadata == null ? {} : JSON.parse(String(current.metadata))
        ) as { decision?: unknown; history?: unknown[] }
        const step = {
          step: "revoked",
          by: "owner",
          at: iso(at),
          confirmedBy: { type: current.confirmed_by_type, id: String(current.confirmed_by_id) },
          ...(decision === undefined ? {} : { decision }),
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        }
        database
          .prepare(
            "UPDATE facts SET status = 'proposed', confirmed_by_type = NULL, confirmed_by_id = NULL, metadata = ?, " +
              "updated_at = ? WHERE id = ?",
          )
          .run(JSON.stringify({ ...metadata, history: [...(history ?? []), step] }), at, Number(row.id))
      })
      return factOf(rowOf(reference))
    },
    reject: (reference, by, reason) => {
      const row = rowOf(reference)
      decided(row, by)
      if (row.status !== "proposed")
        throw new CliError(
          "validation_error",
          `only a proposed fact can be rejected; this one is ${String(row.status)}`,
        )
      write(database, () => {
        database.prepare("UPDATE facts SET status = 'rejected', updated_at = ? WHERE id = ?").run(now(), Number(row.id))
        keepDecision(Number(row.id), by, reason)
        closing(Number(row.id), by, "rejected")
      })
      return factOf(rowOf(reference))
    },
    remove: (reference, by) => {
      const row = rowOf(reference)
      withdrawn(row, by)
      const id = Number(row.id)
      const twin = row.source === "memory" && row.metadata != null ? migratedFrom(String(row.metadata)) : undefined
      const links = erase(database, () => {
        keepHighestId(database, "facts", now())
        if (twin !== undefined) keepHighestId(database, "memories", now())
        database.prepare("UPDATE facts SET supersedes_id = NULL WHERE supersedes_id = ?").run(id)
        eraseSourceReviews(database, { type: "fact", id })
        const count = dropLinksOf(database, { type: "fact", id }, now())
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
    accept: async (reference, by, reason) => operations.accept(reference, by, reason),
    reverse: async (reference, by) => operations.reverse(reference, by),
    revoke: async (reference, by, reason) => operations.revoke(reference, by, reason),
    reject: async (reference, by, reason) => operations.reject(reference, by, reason),
    remove: async (reference, by) => operations.remove(reference, by),
    sources: async (reference) => operations.sources(reference),
  }
}
