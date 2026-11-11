import * as v from "valibot"
import { WEIGHTS } from "../botcheck/reasons.js"
import { count, id, text, time } from "./fields.js"

const linkedIdentity = v.strictObject({
  provider: text,
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  phone: v.optional(v.nullable(text)),
  email: v.optional(v.nullable(text)),
  /** Every phone and address the source gave, `phone` and `email` among them. */
  phones: v.optional(v.array(text)),
  emails: v.optional(v.array(text)),
  is_bot: v.nullable(v.boolean()),
  accounts: v.array(id),
  seen_in: v.array(v.strictObject({ account: id, scope: v.picklist(["personal", "work"]) })),
  method: text,
  linked_by: text,
  linked_at: time,
})

export const linkedPerson = v.strictObject({
  uid: id,
  name: v.nullable(text),
  /** The name `people list` shows: the person's own, else an account's, a username, phone or address. */
  display_name: v.optional(v.nullable(text)),
  identities: v.array(linkedIdentity),
  /** An agent's link: the `identity_link` proposal the owner decides; the person is still as it was. */
  proposal: v.optional(text),
})

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
