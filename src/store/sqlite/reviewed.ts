import { CliError } from "@wirecat/cli-base"
import type { FinanceReview } from "../../domain/finance.js"
import { DECIDED_TABLES, type DecidedTable, type DecidedType } from "../../domain/record-types.js"
import { assertMayDecide, botKey, type Decider, deciderAuthor } from "../decisions.js"
import { type Actor, proposerOf } from "./actors.js"
import {
  type Author,
  authorActor,
  authorOf,
  evidenceOf,
  linkEvidence,
  type Memory,
  projectId,
  projectOf,
  subjectOf,
} from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

type Row = Record<string, unknown>

/** Who wrote a row: `name` is a bot's handle and `kind` whether it is an agent or a rule; both `null` for a person. */
export type AuthorInfo = Memory["author"]

/** A `person:` or `organization:` on an invoice or a payment, with its name so a list needs no lookup. */
export interface Party {
  ref: string
  name: string | null
  /** The owner's own person row. */
  owner: boolean
}

export interface Reviewed {
  review: FinanceReview
  /** `name` is a bot's handle and `kind` whether it is an agent or a rule; both `null` for a person. */
  author: AuthorInfo
  model: string | null
  confirmedBy: { type: Actor["type"]; id: string } | null
  source: string
  /** Why an agent or an import proposed it. */
  reason: string | null
  /** What it was read from: the messages, documents or notes an agent or the owner cited. */
  evidence: string[]
  project: string | null
  projectName: string | null
  createdAt: string
  updatedAt: string
}

export interface Written {
  /** The owner's entry is confirmed at once; a bot's waits as proposed for the owner. */
  by: Author
  project?: string
  /** Where a bot's row came from, such as `agent` or an importer's name; the owner's is always `owner`. */
  source?: string
  /** Why a bot proposes it, kept for the reviewer. */
  reason?: string
  /** References it was read from, linked as `evidence`. */
  evidence?: string[]
}

const article = (word: string) => (/^[aeiou]/.test(word) ? "an" : "a")
/** One article, for the first prefix only: `an invoice: or payment:`. */
export const prefixesText = (types: readonly string[]) =>
  `${article(types[0] ?? "")} ${types.map((type) => `${type}:`).join(" or ")}`

export const refuse = (
  message: string,
  reason: string,
  code: "validation_error" | "permission_error" = "validation_error",
) => {
  throw new CliError(code, message, { reason })
}

export const oneOf = <T extends string>(value: unknown, allowed: readonly T[], what: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T))
    return refuse(`${what} is one of ${allowed.join(", ")}`, "finance.field")
  return value as T
}

export const text = (value: unknown, what: string, limit: number, reason = "finance.field"): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
    return refuse(`${what} takes 1–${limit} characters`, reason)
  return value.trim()
}

export const isoDate = (value: unknown, what: string): string | null => {
  if (value === undefined || value === null) return null
  const date = typeof value === "string" ? value.trim() : ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    return refuse(`${what} is a date such as 2026-11-15`, "finance.field")
  return date
}

export const iso = (value: unknown) => new Date(Number(value)).toISOString()

const evidenceList = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8 || value.some((one) => typeof one !== "string" || !one.trim()))
    return refuse("evidence is a list of at most 8 references", "finance.field")
  return [...new Set(value.map((one: string) => one.trim()))]
}

export const reasonOf = (metadata: unknown): string | null => {
  if (metadata == null) return null
  try {
    const { reason } = JSON.parse(String(metadata)) as { reason?: unknown }
    return typeof reason === "string" ? reason : null
  } catch {
    return null
  }
}

/** A list's page size: 1–500, 100 when left out. */
export const limitOf = (limit: number | undefined) => Math.min(Math.max(limit ?? 100, 1), 500)

export interface Decision {
  by: Decider
  reason?: string
  confirm: boolean
}

/** A reviewed row the owner decides; its `author_name` comes from the bots join every reviewed query makes. */
export const decisionsOver = (context: StoreContext) => {
  const { database, now } = context

  const keepDecision = (table: DecidedTable, id: number, by: Decider, reason?: string) => {
    const why = [by === "owner" ? undefined : by.reason.trim(), reason?.trim() || undefined].filter(Boolean).join(": ")
    if (by === "owner" && !why) return
    const decision = by === "owner" ? { by: "owner", reason: why } : { by: "agent", bot: by.bot, reason: why }
    database
      .prepare(`UPDATE ${table} SET metadata = json_set(coalesce(metadata, '{}'), '$.decision', json(?)) WHERE id = ?`)
      .run(JSON.stringify(decision), id)
  }

  /**
   * Confirms or rejects a proposed row; only the owner decides money. `before` runs the checks that may still refuse
   * and `after` what follows from the decision, both in its transaction.
   */
  const decideRow = (
    type: DecidedType,
    row: Row,
    { by, reason, confirm }: Decision,
    within: { before?: () => void; after?: (confirmer: Actor | null) => void } = {},
  ) => {
    const ref = `${type}:${row.id}`
    assertMayDecide(
      { id: ref, proposedBy: proposerOf(database, row.author_type, row.author_id), ownerOnly: true },
      by,
      context.decisions,
    )
    if (row.review !== "proposed")
      throw new CliError("validation_error", `${ref} is already ${String(row.review)}`, {
        reason: "proposal.wrong-state",
      })
    const table = DECIDED_TABLES[type]
    const id = Number(row.id)
    write(database, () => {
      within.before?.()
      const at = now()
      const confirmer = confirm ? authorActor(context, deciderAuthor(by)).actor : null
      if (confirmer)
        database
          .prepare(
            `UPDATE ${table} SET review = 'confirmed', confirmed_by_type = ?, confirmed_by_id = ?, updated_at = ? WHERE id = ?`,
          )
          .run(confirmer.type, confirmer.id, at, id)
      else database.prepare(`UPDATE ${table} SET review = 'rejected', updated_at = ? WHERE id = ?`).run(at, id)
      keepDecision(table, id, by, reason)
      within.after?.(confirmer)
    })
  }

  /**
   * The one rule for changing a reviewed row or its lines, allocations and splits: the owner changes any; a bot only
   * a row it proposed that is still proposed, as its own draft. A confirmed row is the owner's.
   */
  const mayChangeParts = (row: Row, by: Author, message: string, reason = "finance.owner-only") => {
    if (by === "owner") return
    const own =
      row.author_type === "bot" && row.author_name != null && botKey(String(row.author_name)) === botKey(by.bot)
    if (row.review !== "proposed" || !own) throw new CliError("permission_error", message, { reason })
  }

  return { keepDecision, decideRow, mayChangeParts }
}

/** What invoices, payments and orders share: their parties, who wrote them, and how the owner decides them. */
export const reviewedRowsOver = (context: StoreContext) => {
  const { database } = context

  const partyOf = (type: unknown, id: unknown): Party | null => {
    if (type == null) return null
    const { subject, subjectName, subjectIsOwner } = subjectOf(database, { subject_type: type, subject_id: id })
    return subject === null ? null : { ref: subject, name: subjectName, owner: subjectIsOwner }
  }
  const partyThing = (reference: string | undefined, what: string) => {
    if (reference === undefined) return undefined
    const thing = requiredThing(database, reference, what)
    if (thing.type !== "person" && thing.type !== "organization")
      return refuse(`${what} is a person: or organization: reference, not ${reference}`, "finance.party")
    return thing
  }
  const reviewedOf = (row: Row, type: DecidedType | "deal"): Reviewed => ({
    review: row.review as FinanceReview,
    author: authorOf(row),
    model: row.model == null ? null : String(row.model),
    confirmedBy:
      row.confirmed_by_type == null
        ? null
        : { type: row.confirmed_by_type as Actor["type"], id: String(row.confirmed_by_id) },
    source: String(row.source),
    reason: reasonOf(row.metadata),
    evidence: evidenceOf(context, { type, id: Number(row.id) }),
    ...projectOf(database, row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  })

  const written = (input: Written) => {
    const owner = input.by === "owner"
    const { actor, model } = authorActor(context, input.by)
    const source = owner ? "owner" : (text(input.source, "a source", 80) ?? "agent")
    const reason = owner ? null : text(input.reason, "a reason", 2000)
    return {
      owner,
      actor,
      model,
      source,
      review: owner ? "confirmed" : "proposed",
      confirmedType: owner ? actor.type : null,
      confirmedId: owner ? actor.id : null,
      metadata: reason === null ? null : JSON.stringify({ reason }),
      project: input.project === undefined ? null : projectId(database, input.project),
      evidence: evidenceList(input.evidence),
    }
  }

  const keepEvidence = (type: DecidedType | "deal", id: number, by: ReturnType<typeof written>) => {
    if (by.evidence.length) linkEvidence(context, { type, id }, by.evidence, by.owner ? "owner" : "agent")
  }

  const ownerOnly = (by: Author, what: string) => {
    if (by !== "owner") refuse(`only the owner ${what}`, "finance.owner-only", "permission_error")
  }

  /** A typed ref of one kind, as its row id; `undefined` passes through. */
  const linkedId = <T extends string>(reference: string | undefined, type: T, reason: string): number | null => {
    if (reference === undefined) return null
    const thing = requiredThing(database, reference, `the ${type}`)
    if (thing.type !== type) return refuse(`${reference} is not ${prefixesText([type])} reference`, reason)
    return thing.id
  }

  return { partyOf, partyThing, reviewedOf, written, keepEvidence, ownerOnly, linkedId, ...decisionsOver(context) }
}
