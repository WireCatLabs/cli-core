import type { CacheDatabase } from "../driver.js"
import {
  ERASED_TEXT,
  graver,
  SOURCE_REVIEW_CAUSES,
  SOURCE_REVIEW_KIND,
  type SourceReviewCause,
  type SourceReviewChallenge,
  type SourceReviewMarker,
  type SourceReviewPayload,
  type SourceReviewSource,
  type SourceReviewSuggestion,
  severity,
} from "../source-review.js"
import { type Actor, botNamed } from "./actors.js"

export type ReviewTarget = { type: "memory" | "fact"; id: number }

const TABLES = { memory: "memories", fact: "facts" } as const
export const HOLDING = { memory: ["proposed", "confirmed"], fact: ["proposed", "accepted"] } as const
const KEPT = 20

export const holdingSql = (alias: string, type: ReviewTarget["type"]) =>
  `${alias}.deleted_at IS NULL AND ${alias}.status IN (${HOLDING[type].map((status) => `'${status}'`).join(", ")})`

export const asReviewTarget = (type: unknown, id: unknown): ReviewTarget | undefined =>
  type === "memory" || type === "fact" ? { type, id: Number(id) } : undefined

export const holds = (database: CacheDatabase, target: ReviewTarget): boolean =>
  database
    .prepare(`SELECT 1 FROM ${TABLES[target.type]} t WHERE t.id = ? AND ${holdingSql("t", target.type)}`)
    .get(target.id) !== undefined

/** The rule bot the source check writes its reviews as. */
export const sourceChecker = (database: CacheDatabase, at: number): Actor =>
  botNamed(database, "source-check", at, "rule")

/** The open source review of a memory or fact, through the proposals' target index. */
export const sourceReviewOf = (database: CacheDatabase, target: ReviewTarget): SourceReviewMarker | null => {
  const row = database
    .prepare(
      "SELECT id, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.cause') END AS cause " +
        "FROM proposed_actions WHERE target_type = ? AND target_id = ? AND kind = ? AND status = 'proposed' " +
        "ORDER BY id LIMIT 1",
    )
    .get(target.type, target.id, SOURCE_REVIEW_KIND)
  if (!row) return null
  const cause = SOURCE_REVIEW_CAUSES.find((known) => known === row.cause) ?? "changed"
  return { id: String(row.id), cause }
}

const iso = (at: number) => new Date(at).toISOString()

const payloadOf = (raw: unknown): SourceReviewPayload | undefined => {
  if (typeof raw !== "string") return undefined
  try {
    return JSON.parse(raw) as SourceReviewPayload
  } catch {
    return undefined
  }
}

const causeOf = (payload: Pick<SourceReviewPayload, "sources" | "challenges">): SourceReviewCause =>
  payload.sources.reduce<SourceReviewCause>(
    (worst, source) => graver(worst, source.cause),
    payload.challenges.length ? "contradicted" : "changed",
  )

/**
 * Opens the target's review, or folds new sources, a challenge and a suggestion into the open one, inside the caller's
 * write. Its `raisedAt` moves only when the cause grows graver, so a review climbs the queue for a worse reason and
 * not for the same one again.
 */
export const raiseSourceReview = (
  database: CacheDatabase,
  target: ReviewTarget,
  change: {
    sources?: SourceReviewSource[]
    challenge?: SourceReviewChallenge
    suggestion?: SourceReviewSuggestion
    proposer: Actor
    at: number
  },
): { id: string; changed: boolean } => {
  const ref = `${target.type}:${target.id}`
  const { at } = change
  const open = database
    .prepare(
      "SELECT id, payload FROM proposed_actions WHERE kind = ? AND status = 'proposed' AND target_type = ? " +
        "AND target_id = ? ORDER BY id LIMIT 1",
    )
    .get(SOURCE_REVIEW_KIND, target.type, target.id)
  const before: SourceReviewPayload = payloadOf(open?.payload) ?? {
    target: ref,
    cause: "changed",
    raisedAt: iso(at),
    sources: [],
    challenges: [],
  }
  const merged = new Map(before.sources.map((source) => [source.link, source]))
  for (const source of change.sources ?? []) {
    const held = merged.get(source.link)
    merged.set(
      source.link,
      held === undefined
        ? source
        : {
            ...held,
            ref: source.ref ?? held.ref,
            cause: graver(held.cause, source.cause) as SourceReviewSource["cause"],
            ...(source.replacement === undefined ? {} : { replacement: source.replacement }),
          },
    )
  }
  const suggestions = [...(before.suggestions ?? []), ...(change.suggestion ? [change.suggestion] : [])].slice(-KEPT)
  const next = {
    sources: [...merged.values()],
    challenges: [...before.challenges, ...(change.challenge ? [change.challenge] : [])].slice(-KEPT),
  }
  const cause = causeOf(next)
  const payload: SourceReviewPayload = {
    target: ref,
    cause,
    raisedAt: open && severity(cause) <= severity(before.cause) ? before.raisedAt : iso(at),
    ...next,
    ...(suggestions.length ? { suggestions } : {}),
  }
  if (!open) {
    const made = database
      .prepare(
        "INSERT INTO proposed_actions (kind, target_type, target_id, payload, status, proposed_by_type, proposed_by_id, " +
          "created_at, updated_at) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?) RETURNING id",
      )
      .get(
        SOURCE_REVIEW_KIND,
        target.type,
        target.id,
        JSON.stringify(payload),
        change.proposer.type,
        change.proposer.id,
        at,
        at,
      )
    return { id: String(made?.id), changed: true }
  }
  if (JSON.stringify(payload) === JSON.stringify(before)) return { id: String(open.id), changed: false }
  database
    .prepare("UPDATE proposed_actions SET payload = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(payload), at, Number(open.id))
  return { id: String(open.id), changed: true }
}

/**
 * Closes the open review of a memory or fact that was corrected, withdrawn or removed, inside the caller's write:
 * what the review asked has been answered by that decision.
 */
export const closeSourceReviews = (
  database: CacheDatabase,
  target: ReviewTarget,
  close: { actor: Actor; at: number; why: string },
): number =>
  database
    .prepare(
      "UPDATE proposed_actions SET status = 'executed', decided_by_type = ?, decided_by_id = ?, decided_at = ?, " +
        "executed_at = ?, result = ?, updated_at = ? WHERE target_type = ? AND target_id = ? AND kind = ? " +
        "AND status = 'proposed'",
    )
    .run(
      close.actor.type,
      close.actor.id,
      close.at,
      close.at,
      JSON.stringify({ closed: close.why }),
      close.at,
      target.type,
      target.id,
      SOURCE_REVIEW_KIND,
    ).changes

/**
 * A memory or fact erased takes its source reviews with it: they name it and hold what was said about it, and an
 * erased row leaves nothing pointing at it.
 */
export const eraseSourceReviews = (database: CacheDatabase, target: ReviewTarget): number =>
  database
    .prepare("DELETE FROM proposed_actions WHERE kind = ? AND target_type = ? AND target_id = ?")
    .run(SOURCE_REVIEW_KIND, target.type, target.id).changes

/**
 * Rewrites every source review, open or closed, that quotes or names an erased source: a challenge or a suggestion
 * citing it loses its words and references, and with `refs` a source entry naming it loses its reference.
 */
export const scrubSourceReviews = (
  database: CacheDatabase,
  erased: (ref: string) => boolean,
  { refs }: { refs: boolean },
): number => {
  const update = database.prepare("UPDATE proposed_actions SET payload = ? WHERE id = ?")
  let scrubbed = 0
  for (const row of database
    .prepare("SELECT id, payload FROM proposed_actions WHERE kind = ?")
    .all(SOURCE_REVIEW_KIND)) {
    const payload = payloadOf(row.payload)
    if (!payload) continue
    const names = (evidence: string[] | undefined) => (evidence ?? []).some(erased)
    const next: SourceReviewPayload = {
      ...payload,
      sources: payload.sources.map((source) =>
        refs && source.ref !== null && erased(source.ref)
          ? { ...source, ref: null, kind: source.kind ?? source.ref.split(":")[0] }
          : source,
      ),
      challenges: payload.challenges.map((challenge) =>
        names(challenge.evidence) ? { ...challenge, evidence: [], reason: ERASED_TEXT } : challenge,
      ),
      ...(payload.suggestions === undefined
        ? {}
        : {
            suggestions: payload.suggestions.map((suggestion) =>
              names(suggestion.evidence) ? { ...suggestion, evidence: [], body: ERASED_TEXT } : suggestion,
            ),
          }),
    }
    if (JSON.stringify(next) === JSON.stringify(payload)) continue
    update.run(JSON.stringify(next), Number(row.id))
    scrubbed++
  }
  return scrubbed
}
