import * as v from "valibot"
import { id, text } from "./fields.js"

export const accountProfile = v.strictObject({
  profile: id,
  current: v.boolean(),
  account: v.nullable(id),
  name: v.nullable(text),
})
