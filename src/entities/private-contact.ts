import * as v from "valibot"
import { id, text } from "./fields.js"

export const contactAlias = v.strictObject({ person_id: id, alias: v.nullable(text) })
export const contactNoteRemoval = v.strictObject({ id, person_id: id, removed: v.boolean() })
