import { CliError } from "@wirecat/cli-base"
import { assertMayDecide, type Decider, deciderAuthor } from "../decisions.js"
import { SOURCE_REVIEW_KIND, type SourceCheck, type SourceReviewSource } from "../source-review.js"
import {
  type EvidenceSignature,
  evidenceSignature,
  resignEvidence,
  sourceHolds,
  storedEvidenceMetadata,
} from "./evidence-signature.js"
import { linkKind } from "./link-kinds.js"
import { type Author, authorActor } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { type ProposedAction, proposalOperationsOver, proposerOfAction } from "./proposed-actions.js"
import {
  asReviewTarget,
  closeSourceReviews,
  holdingSql,
  holds,
  type ReviewTarget,
  raiseSourceReview,
  sourceChecker,
} from "./source-review-marks.js"
import { referenceOfThing, storedThing, type Thing } from "./things.js"
import { write } from "./transaction.js"

export interface SourceReviewDecision {
  /** `true`: the memory or fact still holds; `false`: dismiss the review. Either way its sources are signed anew. */
  confirm: boolean
  by: Decider
  reason?: string
}

export interface ChallengeInput {
  /** What contradicts it, as references the store holds. */
  evidence: string[]
  reason: string
  by: Author
  /** What the challenger would say instead, for the owner to take or leave. */
  suggestion?: string
}

type Row = Record<string, unknown>

const TABLES = { memory: "memories", fact: "facts" } as const
const RETIRED = new Set(["superseded", "reversed", "rejected", "stale"])
const DEFAULT_LIMIT = 500
const CURSOR = "source-check.cursor"
const SCAN_FACTOR = 20

/**
 * Evidence links of memories and facts in id order, from a cursor. The unary `+` keeps SQLite off the `from_type`
 * index, which would read every memory's and fact's links and sort them; the primary key stops at `limit`.
 */
export const SOURCE_WALK =
  "SELECT id, from_type, from_id, to_type, to_id, metadata, created_at FROM links WHERE id > ? AND id <= ? " +
  `AND kind = ${linkKind("evidence")} AND +from_type IN ('memory', 'fact') AND to_id IS NOT NULL ORDER BY id LIMIT ?`

const iso = (at: number) => new Date(at).toISOString()

const textLimit = (value: unknown, what: string, reason: string): string => {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text || text.length > 2000) throw new CliError("validation_error", `${what} takes 1–2000 characters`, { reason })
  return text
}

export const sourceReviewOver = (context: StoreContext) => {
  const { database, now } = context
  const operations = proposalOperationsOver(context)

  const statusOf = (target: ReviewTarget): string | undefined => {
    const row = database.prepare(`SELECT status, deleted_at FROM ${TABLES[target.type]} WHERE id = ?`).get(target.id)
    return row && row.deleted_at == null ? String(row.status) : undefined
  }

  /** The newest fact or memory that replaced this one, following `supersedes` while each replacement holds. */
  const replacementOf = (target: ReviewTarget): string | undefined => {
    const next = database.prepare(
      `SELECT id FROM ${TABLES[target.type]} t WHERE t.supersedes_id = ? AND ${holdingSql("t", target.type)} ` +
        "ORDER BY t.id DESC LIMIT 1",
    )
    let current = target.id
    for (let hop = 0; hop < 20; hop++) {
      const found = next.get(current)
      if (!found) break
      current = Number(found.id)
    }
    return current === target.id ? undefined : `${target.type}:${current}`
  }

  /** What one evidence link says now: nothing new, a silent signature, or a cause for review. */
  const judged = (
    link: Row,
    thing: Thing,
    now: EvidenceSignature,
  ): { outcome: "same" | "baselined" | "refreshed" } | { outcome: "raised"; source: SourceReviewSource } => {
    const stored = storedEvidenceMetadata(link.metadata)
    const cited = asReviewTarget(thing.type, thing.id)
    const raise = (cause: SourceReviewSource["cause"]) => {
      const replacement = cause === "outdated" && cited ? replacementOf(cited) : undefined
      return {
        outcome: "raised" as const,
        source: {
          link: Number(link.id),
          ref: referenceOfThing(database, thing) ?? null,
          cause,
          citedRev: stored?.cited_rev ?? null,
          ...(replacement === undefined ? {} : { replacement }),
        },
      }
    }
    const retired = cited !== undefined && RETIRED.has(statusOf(cited) ?? "")
    if (stored === undefined) {
      const since = (at: number | null) => at !== null && at > Number(link.created_at)
      if (now.deleted && (now.changedAt === null || since(now.changedAt))) return raise("deleted")
      if (since(now.changedAt)) {
        if (cited === undefined) return raise("changed")
        if (retired) return raise("outdated")
      }
      return { outcome: "baselined" }
    }
    if (stored.sig === now.sig) return { outcome: "same" }
    if (now.deleted) return raise("deleted")
    if (cited !== undefined) return retired ? raise("outdated") : { outcome: "refreshed" }
    if (stored.quote !== undefined && sourceHolds(database, thing, stored.quote) === true)
      return { outcome: "refreshed" }
    return raise("changed")
  }

  const evidenceLinksOf = (target: ReviewTarget): Row[] =>
    database
      .prepare(
        `SELECT id, to_type, to_id, metadata FROM links WHERE from_type = ? AND from_id = ? AND kind = ${linkKind("evidence")} ` +
          "AND to_id IS NOT NULL",
      )
      .all(target.type, target.id) as Row[]

  const rebaseline = (target: ReviewTarget, at: number) => {
    for (const link of evidenceLinksOf(target))
      resignEvidence(
        database,
        Number(link.id),
        evidenceSignature(database, storedThing(link.to_type, link.to_id)),
        at,
        storedEvidenceMetadata(link.metadata),
      )
  }

  const cursor = (): number =>
    Number(database.prepare("SELECT value FROM store_settings WHERE key = ?").get(CURSOR)?.value ?? 0)

  /**
   * The next evidence links after the cursor, at most `limit`, read from a window of `SCAN_FACTOR * limit` link ids
   * so a store with few evidence links among many others holds the write lock for a bounded time. Returns the cursor
   * the next run starts from: after the last link taken, the window's end, or `0` once the window passed the last link.
   */
  const nextLinks = (limit: number): { links: Row[]; next: number } => {
    const from = cursor()
    const to = from + SCAN_FACTOR * limit
    const links = database.prepare(SOURCE_WALK).all(from, to, limit) as Row[]
    if (links.length === limit) return { links, next: Number(links.at(-1)?.id) }
    const highest = Number(database.prepare("SELECT max(id) AS id FROM links").get()?.id ?? 0)
    return { links, next: to >= highest ? 0 : to }
  }

  return {
    checkSources: ({ limit = DEFAULT_LIMIT }: { limit?: number } = {}): SourceCheck => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
        throw new CliError("validation_error", "a source check takes 1–10000 evidence links")
      return write(database, () => {
        const at = now()
        const counts: SourceCheck = { checked: 0, baselined: 0, raised: 0, refreshed: 0, closed: 0 }
        const raised = new Map<string, { target: ReviewTarget; sources: SourceReviewSource[] }>()
        const retired = new Map<string, ReviewTarget>()
        const { links, next } = nextLinks(limit)
        for (const link of links) {
          counts.checked++
          const target = asReviewTarget(link.from_type, link.from_id) as ReviewTarget
          const key = `${target.type}:${target.id}`
          if (!holds(database, target)) {
            retired.set(key, target)
            continue
          }
          const thing = storedThing(link.to_type, link.to_id)
          const signature = evidenceSignature(database, thing)
          const verdict = judged(link, thing, signature)
          if (verdict.outcome === "same") continue
          resignEvidence(database, Number(link.id), signature, at, storedEvidenceMetadata(link.metadata))
          if (verdict.outcome === "baselined") counts.baselined++
          else if (verdict.outcome === "refreshed") counts.refreshed++
          else if (verdict.outcome === "raised") {
            const entry = raised.get(key) ?? { target, sources: [] }
            entry.sources.push(verdict.source)
            raised.set(key, entry)
          }
        }
        const proposer = sourceChecker(database, at)
        for (const { target, sources } of raised.values())
          if (raiseSourceReview(database, target, { sources, proposer, at }).changed) counts.raised++
        for (const target of retired.values())
          counts.closed += closeSourceReviews(database, target, { actor: proposer, at, why: "no-longer-holds" })
        database
          .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
          .run(CURSOR, String(next), at)
        return counts
      })
    },

    challenge: (reference: string, input: ChallengeInput): ProposedAction => {
      const reason = textLimit(input.reason, "a challenge's reason", "source-review.reason-required")
      const suggestion =
        input.suggestion === undefined
          ? undefined
          : textLimit(input.suggestion, "a suggestion", "source-review.suggestion-length")
      if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > 20)
        throw new CliError("validation_error", "a challenge cites 1–20 references that contradict it", {
          reason: "source-review.evidence-required",
        })
      return write(database, () => {
        const thing = requiredThing(database, reference, "the memory or fact")
        const target = asReviewTarget(thing.type, thing.id)
        if (!target) throw new CliError("validation_error", `${reference} is not a memory or a fact`)
        if (!holds(database, target))
          throw new CliError("validation_error", `${reference} no longer holds; there is nothing to challenge`, {
            reason: "source-review.not-holding",
          })
        const evidence = input.evidence.map(
          (ref) => referenceOfThing(database, requiredThing(database, ref, "the evidence")) ?? ref,
        )
        const at = now()
        const author = input.by === "owner" ? "owner" : input.by.bot
        const { id } = raiseSourceReview(database, target, {
          challenge: { evidence, reason, by: author, at: iso(at) },
          ...(suggestion === undefined ? {} : { suggestion: { author, body: suggestion, evidence, at: iso(at) } }),
          proposer: authorActor(context, input.by).actor,
          at,
        })
        return operations.get(id)
      })
    },

    decide: (id: string, decision: SourceReviewDecision): ProposedAction =>
      write(database, () => {
        const proposal = operations.get(id)
        if (proposal.kind !== SOURCE_REVIEW_KIND)
          throw new CliError("validation_error", `${id} is a ${proposal.kind} proposal, not a source review`)
        assertMayDecide(
          { id, kind: SOURCE_REVIEW_KIND, ownerOnly: true, proposedBy: proposerOfAction(proposal) },
          decision.by,
          context.decisions,
        )
        const row = database.prepare("SELECT target_type, target_id FROM proposed_actions WHERE id = ?").get(Number(id))
        const target = row && asReviewTarget(row.target_type, row.target_id)
        const author = deciderAuthor(decision.by)
        const reason = decision.reason?.trim() || undefined
        const result = { ...(reason === undefined ? {} : { reason }) }
        const decided = decision.confirm
          ? operations.approve(id, { stillTrue: true, ...result }, author)
          : operations.reject(id, author, { dismissed: true, ...result })
        if (target) {
          const at = now()
          rebaseline(target, at)
          if (decision.confirm && target.type === "memory")
            database
              .prepare("UPDATE memories SET last_verified_at = ?, updated_at = ? WHERE id = ?")
              .run(at, at, target.id)
        }
        return decided
      }),
  }
}

/** The knowledge store's part that watches what memories and facts cite. */
export interface SourceReviewStore {
  /**
   * Reads the sources memories and facts that still hold cite, least recently checked first (500 links unless
   * `limit` says), and opens or updates a `memory_source_review` for each one whose sources no longer back it. A
   * changed source that still says the quoted words raises nothing. A link written before signatures is signed in
   * silence unless its source changed or went after it was cited. Status never changes here.
   */
  checkSources(options?: { limit?: number }): Promise<SourceCheck>
  /**
   * Says that a memory or fact is contradicted, citing what contradicts it. It only opens the target's source review
   * or adds to the open one; the owner decides.
   */
  challenge(reference: string, input: ChallengeInput): Promise<ProposedAction>
  /**
   * Decides a `memory_source_review`, the owner's alone: confirm says it still holds and marks a memory verified now,
   * reject dismisses the review. Both sign its sources again as they are now.
   */
  decideSourceReview(id: string, decision: SourceReviewDecision): Promise<ProposedAction>
}

export const sourceReviewStoreOver = (context: StoreContext): SourceReviewStore => {
  const sourceReview = sourceReviewOver(context)
  return {
    checkSources: async (options) => sourceReview.checkSources(options),
    challenge: async (reference, input) => sourceReview.challenge(reference, input),
    decideSourceReview: async (id, decision) => sourceReview.decide(id, decision),
  }
}
