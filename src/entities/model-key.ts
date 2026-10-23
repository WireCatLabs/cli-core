import * as v from "valibot"
import { text } from "./fields.js"

const source = v.picklist(["environment", "keyring", "file"])
export const modelKey = v.strictObject({
  provider: text,
  stored: v.optional(source),
  removed: v.optional(v.array(source)),
})
export const storedModelKey = v.strictObject({ ...v.omit(modelKey, ["removed"]).entries, stored: source })
export const removedModelKey = v.strictObject({ ...v.omit(modelKey, ["stored"]).entries, removed: v.array(source) })
