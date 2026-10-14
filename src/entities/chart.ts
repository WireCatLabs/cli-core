import * as v from "valibot"
import { count, text } from "./fields.js"

/** A chart of a chat's statistics as data; `file` is the image `--output` wrote. */
export const chart = v.strictObject({
  version: v.literal(1),
  kind: v.picklist(["bar", "line", "grouped-bar"]),
  title: text,
  x: v.strictObject({ type: v.picklist(["day", "week"]), values: v.array(text) }),
  series: v.array(v.strictObject({ name: text, values: v.array(v.nullable(v.number())) })),
  unit: v.picklist(["messages", "people"]),
  timezone: text,
  /** Lower bounds: the store or the events did not hold the whole period. */
  partial: v.boolean(),
  reasons: v.array(v.picklist(["store-incomplete", "events-incomplete"])),
  file: v.optional(v.strictObject({ path: text, format: v.picklist(["svg", "png"]), width: count, height: count })),
})
