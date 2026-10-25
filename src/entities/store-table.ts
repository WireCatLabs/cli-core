import * as v from "valibot"
import { count, text } from "./fields.js"

export const TABLE_KINDS = ["data", "search_index", "search_index_part", "internal"] as const

export const storeTable = v.strictObject({
  name: text,
  kind: v.picklist(TABLE_KINDS),
  rows: v.nullable(count),
  bytes: v.optional(v.nullable(count)),
})
