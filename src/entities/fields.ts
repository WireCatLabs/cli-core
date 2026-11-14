import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { SOURCE_REVIEW_CAUSES } from "../store/source-review.js"

export { reference }

export const text = v.string()
export const id = v.pipe(v.string(), v.minLength(1))
export const time = isoTime
/** A time a caller types, read by the shared past-time grammar (`momentOf`). Answers carry `time`, always UTC. */
export const typedTime = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.description("an ISO 8601 date or time, in the computer's zone without one; or 30m, 2h, 7d ago"),
)
export const count = v.pipe(v.number(), v.integer(), v.minValue(0))

/** Fields of an answer item someone other than the owner wrote, as dotted paths: an agent reads them as data. */
export const untrusted = v.optional(v.array(text))

export const providerMetadata = v.optional(v.record(v.string(), v.unknown()))

/** A reference a memory or fact rests on, read back; `missing` once it was deleted since. */
export const evidenceSource = v.strictObject({
  ref: v.nullable(reference),
  kind: text,
  title: v.nullable(text),
  sender: v.nullable(text),
  at: v.nullable(time),
  excerpt: v.nullable(text),
  tool: v.nullable(text),
  missing: v.boolean(),
})

/** The open review of a memory's or fact's sources, when one waits for the owner (`memory_source_review`). */
export const sourceReview = v.nullable(v.strictObject({ id, cause: v.picklist(SOURCE_REVIEW_CAUSES) }))

export const author = v.strictObject({
  type: v.picklist(["person", "bot"]),
  id,
  name: v.nullable(text),
})
