import * as v from "valibot"
import { text, time } from "./fields.js"

export const template = v.strictObject({
  key: text,
  channel: v.picklist(["telegram", "email", "text"]),
  language: text,
  about: text,
  renders: v.boolean(),
  source: v.picklist(["stored", "default"]),
  updated_at: v.nullable(time),
  updated_by: v.nullable(text),
})
