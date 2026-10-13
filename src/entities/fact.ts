import * as v from "valibot"
import { FACT_STATUSES, FACT_TYPES } from "../store/sqlite/facts.js"
import { MEMORY_SCOPES } from "../store/sqlite/memories.js"
import { author, id, reference, text, time } from "./fields.js"

export const fact = v.strictObject({
  ref: reference,
  id,
  kind: v.picklist(FACT_TYPES),
  text,
  status: v.picklist(FACT_STATUSES),
  project: v.nullable(text),
  subject: v.nullable(reference),
  occurredAt: v.nullable(time),
  supersedes: v.nullable(reference),
  author,
  model: v.nullable(text),
  scope: v.nullable(v.picklist(MEMORY_SCOPES)),
  source: text,
  evidence: v.array(reference),
  createdAt: time,
  updatedAt: time,
})
