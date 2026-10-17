import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"

export const communicationFields = {
  sources: v.pipe(
    v.array(
      v.strictObject({
        id: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
        cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
      }),
    ),
    v.minLength(1),
    v.maxLength(8),
  ),
  query: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
}
const schema = v.strictObject({
  ...communicationFields,
  after: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  before: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
})
export type MeetingCommunicationsRequest = v.InferOutput<typeof schema>

export const communicationRequest = (value: unknown, preparationAfter: number) => {
  const parsed = v.safeParse(schema, value)
  if (!parsed.success) {
    const field = parsed.issues[0]?.path?.map((p) => String(p.key)).join(".") ?? "arguments"
    throw new CliError("validation_error", `invalid communications.${field}`)
  }
  const input = parsed.output
  const words = input.query.match(/[\p{L}\p{N}]+/gu) ?? []
  if (Buffer.byteLength(input.query) > 2048 || !words.length || words.length > 16)
    throw new CliError("validation_error", "communications.query needs 1–16 literal words within 2048 UTF-8 bytes")
  const before = input.before ?? preparationAfter
  const after = input.after ?? Math.max(0, before - 14 * 86400000)
  if (before > preparationAfter || after >= before || before - after > 90 * 86400000)
    throw new CliError(
      "validation_error",
      "communications window must be nonempty, span at most 90 days and end by preparation after",
    )
  if (new Set(input.sources.map((s) => s.id)).size !== input.sources.length)
    throw new CliError("validation_error", "communications.sources must not repeat a selection")
  return { ...input, after, before }
}
