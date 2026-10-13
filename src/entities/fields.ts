import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"

export { reference }

export const text = v.string()
export const id = v.pipe(v.string(), v.minLength(1))
export const time = isoTime
export const count = v.pipe(v.number(), v.integer(), v.minValue(0))

export const providerMetadata = v.optional(v.record(v.string(), v.unknown()))

export const author = v.strictObject({
  type: v.picklist(["person", "bot"]),
  id,
  name: v.nullable(text),
})
