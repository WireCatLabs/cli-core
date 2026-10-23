import * as v from "valibot"
import { id, reference, text, time } from "./fields.js"

export const documentLink = v.strictObject({
  ref: reference,
  url: text,
  document_id: v.nullable(id),
  title: v.nullable(text),
  in_store: v.boolean(),
  sent_at: time,
  sender: v.strictObject({ id: v.nullable(id), name: v.nullable(text) }),
})
