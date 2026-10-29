import * as v from "valibot"
import { id, reference, text, time } from "./fields.js"

export const organization = v.strictObject({
  id,
  ref: reference,
  kind: v.picklist(["company", "team", "family", "community"]),
  name: text,
  scope: v.picklist(["personal", "work"]),
  created_at: time,
})
export const project = v.strictObject({
  id,
  ref: reference,
  key: text,
  name: text,
  kind: v.picklist(["project", "inbox"]),
  type: v.picklist(["work", "client", "personal", "oss", "other"]),
  organization_id: v.nullable(id),
  scope: v.picklist(["personal", "work"]),
  created_at: time,
})
export const reminder = v.strictObject({
  id,
  task: text,
  due_at: time,
  timezone: text,
  state: v.picklist(["pending", "leased", "delivered", "cancelled"]),
  revision: v.number(),
  receipt: v.nullable(text),
})
