import * as v from "valibot"
import { MEMORY_KINDS, MEMORY_SCOPES, MEMORY_STATUSES } from "../store/sqlite/memories.js"
import { author, id, reference, text, time } from "./fields.js"

export const memory = v.strictObject({
  ref: reference,
  id,
  kind: v.picklist(MEMORY_KINDS),
  text,
  subject: v.nullable(reference),
  author,
  model: v.nullable(text),
  confidence: v.nullable(v.number()),
  status: v.picklist(MEMORY_STATUSES),
  scope: v.picklist(MEMORY_SCOPES),
  supersedes: v.nullable(reference),
  evidence: v.array(reference),
  lastVerifiedAt: v.nullable(time),
  createdAt: time,
  updatedAt: time,
})
