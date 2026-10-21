import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"

export { reference }

export const text = v.string()
export const id = v.pipe(v.string(), v.minLength(1))
export const time = isoTime
/** A time a caller sends: any offset, read as the moment it names. Answers carry `time`, always UTC. */
export const zonedTime = v.pipe(v.string(), v.isoTimestamp("an ISO 8601 time with a zone"))
export const count = v.pipe(v.number(), v.integer(), v.minValue(0))

export const providerMetadata = v.optional(v.record(v.string(), v.unknown()))

export const author = v.strictObject({
  type: v.picklist(["person", "bot"]),
  id,
  name: v.nullable(text),
})
