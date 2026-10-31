import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"

export { reference }

export const text = v.string()
export const id = v.pipe(v.string(), v.minLength(1))
export const time = isoTime
/** A time a caller sends: any offset, read as the moment it names. Answers carry `time`, always UTC. */
export const zonedTime = v.pipe(v.string(), v.isoTimestamp("an ISO 8601 time with a zone"))
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

export const author = v.strictObject({
  type: v.picklist(["person", "bot"]),
  id,
  name: v.nullable(text),
})
