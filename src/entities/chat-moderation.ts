import * as v from "valibot"
import { count, id, text } from "./fields.js"

const action = v.picklist(["report", "delete", "remove"])
const level = v.picklist(["deny", "readonly", "ask", "allow"])
export const chatRules = v.strictObject({
  chat_id: id,
  title: v.nullable(text),
  file: text,
  saved: v.boolean(),
  rules: v.strictObject({
    title: v.nullable(text),
    trusted: v.array(id),
    blocked: v.array(id),
    blocked_names: v.array(text),
    links: action,
    invites: action,
    forwards: action,
    blocked_people: action,
    flood: v.strictObject({ messages: count, minutes: count, action }),
    new_account: v.strictObject({ days: count, action: v.picklist(["report", "remove"]) }),
    consent: v.strictObject({ delete: level, remove: level }),
  }),
})
export const chatModeration = v.strictObject({
  chat_id: id,
  rows: v.array(
    v.strictObject({
      kind: v.picklist(["message", "member"]),
      rule: v.picklist(["blocked", "invites", "links", "forwards", "flood", "newAccount"]),
      person_id: id,
      person_name: v.nullable(text),
      message_id: v.optional(id),
      action,
      outcome: v.picklist(["reported", "done", "planned", "forbidden", "declined", "refused", "failed", "skipped"]),
      reason: v.optional(text),
      command: v.optional(text),
    }),
  ),
})
