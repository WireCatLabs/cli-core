import * as v from "valibot"
import { WEIGHTS } from "../botcheck/reasons.js"
import { count, id, text, time } from "./fields.js"

const linkedIdentity = v.strictObject({
  provider: text,
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  is_bot: v.nullable(v.boolean()),
  accounts: v.array(id),
  method: text,
  linked_by: text,
  linked_at: time,
})

export const linkedPerson = v.strictObject({ uid: id, name: v.nullable(text), identities: v.array(linkedIdentity) })

export const contactActivity = v.strictObject({
  at: time,
  subject: text,
  subject_id: count,
  role: text,
  scope: text,
  provider: v.nullable(text),
  account: v.nullable(text),
  chat_id: v.nullable(text),
  locator: v.nullable(text),
  project_id: v.nullable(count),
})

const botReason = v.picklist(Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[])
export const contactCheck = v.strictObject({
  person: v.strictObject({ id, name: v.nullable(text), username: v.nullable(text), provider: text }),
  score: count,
  reasons: v.array(v.strictObject({ reason: botReason, weight: count, source: text, detail: v.optional(text) })),
  registries: v.array(
    v.strictObject({
      name: v.picklist(["cas", "lols"]),
      answer: v.picklist(["listed", "clean", "unknown"]),
      checked_at: time,
      detail: v.optional(text),
      reasons: v.optional(v.array(v.picklist(["cas_banned", "lols_banned", "lols_scammer"]))),
    }),
  ),
  unknown: v.array(botReason),
  checked_at: time,
})
