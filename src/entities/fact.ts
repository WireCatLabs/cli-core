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
  occurred_at: v.nullable(time),
  supersedes: v.nullable(reference),
  author,
  model: v.nullable(text),
  /** Who accepted it; `null` while it is proposed. */
  confirmed_by: v.optional(v.nullable(v.strictObject({ type: v.picklist(["person", "bot"]), id }))),
  scope: v.nullable(v.picklist(MEMORY_SCOPES)),
  /** Who recorded it: the owner, or an agent whose fact waits as proposed. */
  origin: v.picklist(["owner", "agent"]),
  evidence: v.array(reference),
  created_at: time,
  updated_at: time,
})
