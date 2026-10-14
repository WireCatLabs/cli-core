import * as v from "valibot"
import { counterReading, milliseconds } from "./counter-reading.js"
import { count, reference, text, time } from "./fields.js"

/** Stored counters of the matching messages, each with how fresh its observation is. */
export const counters = v.strictObject({
  cutoff: time,
  max_age_ms: milliseconds,
  /** Pins exactly these messages for `counters refresh --selection`. */
  selection: v.strictObject({
    kind: v.literal("counter-targets"),
    version: v.literal(1),
    locators: v.array(reference),
  }),
  rows: v.array(v.strictObject({ ref: reference, counters: v.array(counterReading) })),
})

/** What a counter refresh read, or with `--dry-run` would read, from the messenger. */
export const counterRefresh = v.strictObject({
  dry_run: v.boolean(),
  targets: v.array(reference),
  counters: v.array(text),
  supported: v.array(text),
  unsupported: v.array(text),
  max_messages: count,
  time_ms: milliseconds,
  results: v.optional(
    v.array(
      v.strictObject({
        ref: reference,
        updated: v.array(text),
        missing: v.array(text),
        status: text,
      }),
    ),
  ),
  stopped: v.optional(text),
  complete: v.optional(v.boolean()),
})
