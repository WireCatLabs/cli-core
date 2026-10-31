import * as v from "valibot"
import { FACT_STATUSES, FACT_TYPES, MEMORY_SCOPES } from "../domain/knowledge.js"
import { author, evidenceSource, id, reference, text, time } from "./fields.js"

export const fact = v.strictObject({
  ref: reference,
  id,
  kind: v.picklist(FACT_TYPES),
  text,
  status: v.picklist(FACT_STATUSES),
  project: v.nullable(text),
  subject: v.nullable(reference),
  /** What the subject is called; `null` for the owner and for a row with no name. */
  subject_name: v.optional(v.nullable(text)),
  subject_is_owner: v.optional(v.boolean()),
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
  /** With `--sources`: each piece of evidence read back. */
  sources: v.optional(v.array(evidenceSource)),
  created_at: time,
  updated_at: time,
})
